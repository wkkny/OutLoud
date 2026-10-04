"""Durable subject-scoped study records, independent of model conversation memory."""
import json
import uuid
from datetime import datetime, timezone

from pydantic import BaseModel, Field, ConfigDict


def now():
    return datetime.now(timezone.utc).isoformat()


class TopicInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    id: str | None = Field(default=None, max_length=128)
    name: str = Field(min_length=1, max_length=200)
    coverage: str = Field(default='', max_length=4000)
    weight: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)


class SubjectInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    exam_type: str = Field(default='not_sure', max_length=200)
    level: str = Field(default='', max_length=200)
    exam_date: str = Field(default='', max_length=20)
    topics: list[TopicInput] = Field(default_factory=list, max_length=200)


class StudyStore:
    def __init__(self, conversations):
        self.conversations = conversations
        self.db = conversations.db
        self.lock = conversations.lock
        with self.lock, self.db:
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS study_subjects (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, exam_type TEXT NOT NULL,
                    level TEXT NOT NULL, exam_date TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS study_topics (
                    id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES study_subjects(id) ON DELETE CASCADE,
                    name TEXT NOT NULL, coverage TEXT NOT NULL, weight REAL, active INTEGER NOT NULL DEFAULT 1,
                    revision INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL, reassessment INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS study_evidence (
                    user_message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                    topic_id TEXT NOT NULL REFERENCES study_topics(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL, created_at TEXT NOT NULL,
                    question TEXT NOT NULL, action TEXT NOT NULL, hinted INTEGER NOT NULL,
                    result TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS study_uploads (
                    id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES study_subjects(id) ON DELETE CASCADE,
                    name TEXT NOT NULL, role TEXT NOT NULL, pages TEXT NOT NULL, text TEXT NOT NULL,
                    approved INTEGER NOT NULL DEFAULT 0, topic_ids TEXT NOT NULL, original BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS study_sessions (
                    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
                    topic_id TEXT NOT NULL REFERENCES study_topics(id) ON DELETE CASCADE,
                    question TEXT NOT NULL, hinted INTEGER NOT NULL DEFAULT 0,
                    finished INTEGER NOT NULL DEFAULT 0
                );
            ''')
            columns = {row[1] for row in self.db.execute('PRAGMA table_info(study_topics)')}
            if 'reassessment' not in columns:
                self.db.execute('ALTER TABLE study_topics ADD COLUMN reassessment INTEGER NOT NULL DEFAULT 0')
            session_columns = {row[1] for row in self.db.execute('PRAGMA table_info(study_sessions)')}
            if 'last_action' not in session_columns:
                self.db.execute("ALTER TABLE study_sessions ADD COLUMN last_action TEXT NOT NULL DEFAULT 'answer'")
            conversations.on_delete = self.before_delete_conversation

    def list(self):
        with self.lock:
            return [self.get(row[0]) for row in self.db.execute('SELECT id FROM study_subjects ORDER BY created_at DESC')]

    def get(self, subject_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM study_subjects WHERE id=?', (subject_id,)).fetchone()
            if row is None:
                raise LookupError('Subject not found')
            result = dict(row)
            result['topics'] = [{**dict(topic), 'judgment': 'not_assessed', 'assessment': None, 'needs_reassessment': False} for topic in self.db.execute('SELECT * FROM study_topics WHERE subject_id=? ORDER BY position', (subject_id,))]
            result['uploads'] = self.uploads(subject_id)
            for topic in result['topics']:
                evidence = self.evidence(topic['id'])
                topic['history'] = evidence
                eligible = self.valid_evidence(topic, evidence, result['uploads'])
                scored = [item for item in eligible if not item['result']['provisional'] and item['action'] == 'answer']
                latest = scored[-1] if scored else eligible[-1] if eligible else None
                if latest:
                    topic['assessment'] = {**latest['result'], 'created_at': latest['created_at'], 'answer': latest['answer'], 'question': latest['question'], 'hinted': bool(latest['hinted'])}
                    topic['judgment'] = topic['assessment']['judgment']
                topic['needs_reassessment'] = bool(not scored and (topic['reassessment'] or any(not item['result']['provisional'] for item in evidence)))
            active = [topic for topic in result['topics'] if topic['active']]
            result['coverage'] = {'total': len(active), 'assessed': sum(topic['judgment'] != 'not_assessed' for topic in active), 'demonstrated': sum(topic['judgment'] == 'demonstrated' for topic in active)}
            rank = {'needs_revision': 3, 'partial': 2, 'not_assessed': 1, 'demonstrated': 0}
            result['revision_order'] = [topic['id'] for topic in sorted(active, key=lambda topic: (rank[topic['judgment']], topic['weight'] if topic['weight'] is not None else -1), reverse=True)]
            return result

    def create(self, body):
        subject_id = str(uuid.uuid4())
        with self.lock, self.db:
            self.db.execute('INSERT INTO study_subjects VALUES(?,?,?,?,?,?)', (subject_id, body.name.strip(), body.exam_type, body.level, body.exam_date, now()))
            for index, topic in enumerate(body.topics):
                self.db.execute('INSERT INTO study_topics(id,subject_id,name,coverage,weight,position) VALUES(?,?,?,?,?,?)', (str(uuid.uuid4()), subject_id, topic.name.strip(), topic.coverage, topic.weight, index))
            return self.get(subject_id)

    def update(self, subject_id, body):
        with self.lock, self.db:
            self.get(subject_id)
            self.db.execute('UPDATE study_subjects SET name=?,exam_type=?,level=?,exam_date=? WHERE id=?', (body.name.strip(), body.exam_type, body.level, body.exam_date, subject_id))
            seen = set()
            for index, topic in enumerate(body.topics):
                topic_id = topic.id or str(uuid.uuid4())
                if topic_id in seen:
                    raise ValueError('Duplicate topic ID')
                seen.add(topic_id)
                existing = self.db.execute('SELECT * FROM study_topics WHERE id=?', (topic_id,)).fetchone()
                if topic.id:
                    if existing is None or existing['subject_id'] != subject_id:
                        raise ValueError('Topic does not belong to this subject')
                    self.db.execute('UPDATE study_topics SET name=?, coverage=?, weight=?, active=1, position=?, revision=revision+? WHERE id=?', (topic.name.strip(), topic.coverage, topic.weight, index, int(existing['coverage'] != topic.coverage), topic_id))
                else:
                    self.db.execute('INSERT INTO study_topics(id,subject_id,name,coverage,weight,position) VALUES(?,?,?,?,?,?)', (topic_id, subject_id, topic.name.strip(), topic.coverage, topic.weight, index))
            for row in self.db.execute('SELECT id FROM study_topics WHERE subject_id=?', (subject_id,)).fetchall():
                if row[0] not in seen:
                    self.db.execute('UPDATE study_topics SET active=0 WHERE id=?', (row[0],))
            return self.get(subject_id)

    def start_conversation(self, subject_id, topic_id):
        with self.lock, self.db:
            subject = self.get(subject_id)
            topic = next((item for item in subject['topics'] if item['id'] == topic_id and item['active']), None)
            if topic is None:
                raise LookupError('Active topic not found')
            conversation = self.conversations.create(f"{subject['name']} · {topic['name']}")
            self.db.execute('INSERT INTO study_sessions(conversation_id,topic_id,question) VALUES(?,?,?)', (conversation['id'], topic_id, f"Explain {topic['name']} in your own words. Include a concrete example and what you find difficult."))
            return self.session(conversation['id'])

    def session(self, conversation_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM study_sessions WHERE conversation_id=?', (conversation_id,)).fetchone()
            if row is None:
                return None
            topic = self.db.execute('SELECT subject_id FROM study_topics WHERE id=?', (row['topic_id'],)).fetchone()
            subject = self.get(topic[0])
            result = dict(row)
            result['subject'] = subject
            result['topic'] = next(item for item in subject['topics'] if item['id'] == row['topic_id'])
            return result

    def uploads(self, subject_id):
        with self.lock:
            result = []
            for row in self.db.execute('SELECT id,subject_id,name,role,pages,text,approved,topic_ids FROM study_uploads WHERE subject_id=? ORDER BY rowid', (subject_id,)):
                item = dict(row)
                item['pages'] = json.loads(item['pages'])
                item['topic_ids'] = json.loads(item['topic_ids'])
                item['approved'] = bool(item['approved'])
                result.append(item)
            return result

    def add_upload(self, subject_id, name, role, data, text, pages):
        with self.lock, self.db:
            self.get(subject_id)
            count, size = self.db.execute('SELECT COUNT(*),COALESCE(SUM(length(original)),0) FROM study_uploads WHERE subject_id=?', (subject_id,)).fetchone()
            if count >= 20 or size + len(data) > 64 * 1024 * 1024:
                raise ValueError('Subject upload limit reached (20 files or 64 MB). Remove unused files first.')
            upload_id = str(uuid.uuid4())
            self.db.execute('INSERT INTO study_uploads VALUES(?,?,?,?,?,?,?,?,?)', (upload_id, subject_id, name[:200], role, json.dumps(pages), text, 0, '[]', data))
            return next(item for item in self.uploads(subject_id) if item['id'] == upload_id)

    def approve_upload(self, upload_id, text, topic_ids, topics):
        with self.lock, self.db:
            upload = self.db.execute('SELECT * FROM study_uploads WHERE id=?', (upload_id,)).fetchone()
            if upload is None:
                raise LookupError('Upload not found')
            subject = self.get(upload['subject_id'])
            known = {topic['id'] for topic in subject['topics'] if topic['active']}
            if not set(topic_ids).issubset(known):
                raise ValueError('Reference topics must belong to this subject')
            if upload['role'] == 'syllabus':
                names = {topic['name'].casefold() for topic in subject['topics'] if topic['active']}
                for topic in topics:
                    if topic.name.casefold() not in names:
                        if len(names) >= 200:
                            raise ValueError('A syllabus can have at most 200 active topics.')
                        self.db.execute('INSERT INTO study_topics(id,subject_id,name,coverage,weight,position) VALUES(?,?,?,?,?,?)', (str(uuid.uuid4()), subject['id'], topic.name, topic.coverage, topic.weight, len(names)))
                        names.add(topic.name.casefold())
            if upload['approved'] and (upload['text'] != text or json.loads(upload['topic_ids']) != topic_ids):
                all_topics = {topic['id'] for topic in subject['topics']}
                affected = (set(json.loads(upload['topic_ids'])) or all_topics) | (set(topic_ids) or all_topics)
                for topic in subject['topics']:
                    if not affected or topic['id'] in affected:
                        self.db.execute('UPDATE study_topics SET revision=revision+1 WHERE id=?', (topic['id'],))
            self.db.execute('UPDATE study_uploads SET text=?,approved=1,topic_ids=? WHERE id=?', (text, json.dumps(topic_ids), upload_id))
            return next(item for item in self.uploads(subject['id']) if item['id'] == upload_id)


    def evidence(self, topic_id):
        with self.lock:
            return [{**dict(row), 'result': json.loads(row['result'])} for row in self.db.execute(
                'SELECT e.*,m.content AS answer,m.conversation_id FROM study_evidence e JOIN messages m ON m.id=e.user_message_id WHERE e.topic_id=? ORDER BY e.rowid', (topic_id,))]

    @staticmethod
    def applicable_references(topic_id, uploads):
        return [upload for upload in uploads if upload['approved'] and upload['role'] == 'reference' and (not upload['topic_ids'] or topic_id in upload['topic_ids'])]

    def valid_evidence(self, topic, evidence, uploads):
        sources = {upload['id'] for upload in self.applicable_references(topic['id'], uploads)}
        eligible, valid_ids = [], set()
        # Evidence only depends on earlier completed answers and itself. Checking
        # in save order validates the whole dependency chain without recursion.
        for item in evidence:
            own_id = item['user_message_id']
            dependencies = set(item['result'].get('evidence_ids', [])) - {own_id}
            if item['revision'] == topic['revision'] and set(item['result']['sources']).issubset(sources) and dependencies.issubset(valid_ids):
                eligible.append(item)
                valid_ids.add(own_id)
        return eligible

    def prepare(self, conversation_id, action):
        with self.lock:
            session = self.session(conversation_id)
            if session is None:
                return None
            topic, subject = session['topic'], session['subject']
            if not topic['active']:
                raise ValueError('Topic was removed from the active syllabus. Choose an active topic.')
            references, remaining, reference_context_incomplete = [], 4000, False
            for upload in self.applicable_references(topic['id'], subject['uploads']):
                text = upload['text'][:min(2000, remaining)]
                reference_context_incomplete |= len(text) < len(upload['text'])
                if text:
                    references.append({'id': upload['id'], 'name': upload['name'] + ' pages ' + ','.join(map(str, upload['pages'])), 'text': text})
                    remaining -= len(text)
            prior = [item for item in self.valid_evidence(topic, topic['history'], subject['uploads']) if item['action'] == 'answer' and not item['hinted'] and not item['result']['provisional'] and set(item['result']['sources']).issubset({ref['id'] for ref in references})]
            return {'conversation_id': conversation_id, 'topic_id': topic['id'], 'revision': topic['revision'], 'topic': topic['name'], 'coverage': topic['coverage'][:1000], 'exam_type': subject['exam_type'], 'level': subject['level'], 'action': action, 'question': session['question'], 'hinted': bool(session['hinted']), 'references': references, 'reference_context_incomplete': reference_context_incomplete, 'independent_count': len(prior), 'previous_evidence': list({evidence_id for item in prior[-2:] for evidence_id in [item['user_message_id'], *item['result'].get('evidence_ids', [])]}), 'previous_answers': [{'question': item['question'], 'answer': item['answer'][:800]} for item in prior[-2:]], 'topic_progress': [{'name': item['name'], 'judgment': item['judgment'], 'exam_importance': item['weight']} for item in subject['topics'] if item['active']][:10], 'subject_coverage': subject['coverage']}

    def begin_attempt(self, plan):
        # Shares the accepted user turn's transaction, including interrupted turns.
        self.db.execute('UPDATE study_sessions SET last_action=? WHERE conversation_id=?', (plan['action'], plan['conversation_id']))

    def complete(self, plan, result, user_message_id):
        # Called inside the conversation's completion transaction and lock.
        topic = self.db.execute('SELECT * FROM study_topics WHERE id=?', (plan['topic_id'],)).fetchone()
        session = self.db.execute('SELECT 1 FROM study_sessions WHERE conversation_id=?', (plan['conversation_id'],)).fetchone()
        if topic is None or session is None:
            return
        uploads = self.uploads(topic['subject_id'])
        current_sources = {upload['id'] for upload in self.applicable_references(topic['id'], uploads)}
        valid_ids = {item['user_message_id'] for item in self.valid_evidence(topic, self.evidence(topic['id']), uploads)}
        if topic['revision'] != plan['revision'] or not topic['active'] or not set(result['sources']).issubset(current_sources) or not set(plan['previous_evidence']).issubset(valid_ids):
            rendered = '**Provisional guidance · study evidence changed; reassessment needed**\n\n' + result['feedback']
            if result['question']:
                rendered += '\n\n**Next question**\n\n' + result['question']
            result = {**result, 'judgment': 'not_assessed', 'gaps': [], 'provisional': True, 'rendered': rendered}
        result = {**result, 'evidence_ids': [*plan['previous_evidence'], user_message_id]}
        self.db.execute('INSERT INTO study_evidence VALUES(?,?,?,?,?,?,?,?)', (user_message_id, plan['topic_id'], plan['revision'], now(), plan['question'], plan['action'], plan['hinted'], json.dumps(result)))
        self.db.execute('UPDATE study_sessions SET question=?,hinted=?,finished=? WHERE conversation_id=?', (result['question'] or plan['question'], int(plan['action'] == 'explain'), int(plan['action'] == 'finish'), plan['conversation_id']))
        return result

    def delete_upload(self, upload_id):
        with self.lock, self.db:
            deleted = self.db.execute('DELETE FROM study_uploads WHERE id=?', (upload_id,))
            if not deleted.rowcount:
                raise LookupError('Upload not found')

    def delete_subject(self, subject_id):
        with self.lock, self.db:
            self.get(subject_id)
            conversations = [row[0] for row in self.db.execute('SELECT s.conversation_id FROM study_sessions s JOIN study_topics t ON t.id=s.topic_id WHERE t.subject_id=?', (subject_id,))]
            for conversation_id in conversations:
                self.conversations.delete(conversation_id)
            self.db.execute('DELETE FROM study_subjects WHERE id=?', (subject_id,))
            return conversations


    def before_delete_conversation(self, conversation_id):
        # Invoked before message FK cascades in the conversation deletion transaction.
        self.db.execute('UPDATE study_topics SET reassessment=1 WHERE id IN (SELECT e.topic_id FROM study_evidence e JOIN messages m ON m.id=e.user_message_id WHERE m.conversation_id=?)', (conversation_id,))


    def original_upload(self, upload_id):
        with self.lock:
            row = self.db.execute('SELECT name,original FROM study_uploads WHERE id=?', (upload_id,)).fetchone()
            if row is None:
                raise LookupError('Upload not found')
            return row['name'], bytes(row['original'])
