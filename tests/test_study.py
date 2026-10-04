"""Study behavior through the HTTP interface, with Ollama as the external seam."""
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx2
from outloud.runtime import RecordingRuntime
from outloud.server import create_app
from test_server import FakeRecorder, LocalTestClient, ORIGIN, receive_type


class StudyTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'conversations.sqlite3'
        model = patch('outloud.transcription.whisper.load_model')
        model.start().return_value.transcribe.return_value = {'text': 'My reviewed study answer'}
        self.addCleanup(model.stop)
        self.requests = []
        self.handler = self.reply
        self.client = self.open_client()
        self.addCleanup(lambda: self.client.__exit__(None, None, None))

    async def reply(self, request):
        self.requests.append(json.loads(request.content))
        return httpx2.Response(200, json={'message': {'content': json.dumps({'feedback': 'Correct definition.', 'question': 'Normalize the student table.', 'judgment': 'demonstrated', 'confident': True, 'sources': [], 'gaps': []})}, 'done': True})

    def open_client(self):
        app = create_app(
            lambda publish: RecordingRuntime(publish, FakeRecorder(Path(self.directory.name)), delivery_path=Path(self.directory.name) / 'delivery.sqlite3'),
            conversations_path=self.path,
            ollama_client_factory=lambda: httpx2.AsyncClient(base_url='http://127.0.0.1:11434', transport=httpx2.MockTransport(lambda request: self.handler(request))),
        )
        client = LocalTestClient(app, base_url='http://127.0.0.1:8765')
        client.__enter__()
        return client

    def create_subject(self):
        response = self.client.post('/study/subjects', json={'name': 'DBMS', 'exam_type': 'written', 'topics': [{'name': 'Normalization'}, {'name': 'Transactions', 'weight': 20}]})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_subject_syllabus_and_exam_details_survive_restart(self):
        subject = self.create_subject()
        self.client.__exit__(None, None, None)
        self.client = self.open_client()
        saved = self.client.get(f"/study/subjects/{subject['id']}").json()
        self.assertEqual(saved['name'], 'DBMS')
        self.assertEqual(saved['exam_type'], 'written')
        self.assertEqual([(topic['name'], topic['weight'], topic['judgment']) for topic in saved['topics']], [('Normalization', None, 'not_assessed'), ('Transactions', 20, 'not_assessed')])

    def test_changed_topic_coverage_requires_reassessment_but_rename_keeps_identity(self):
        subject = self.create_subject()
        topic = subject['topics'][0]
        body = {'name': 'DBMS', 'exam_type': 'written', 'topics': [{'id': topic['id'], 'name': 'Normal forms', 'coverage': '1NF, 2NF, 3NF'}]}
        changed = self.client.patch(f"/study/subjects/{subject['id']}", json=body)
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()['topics'][0]['id'], topic['id'])
        self.assertEqual(changed.json()['topics'][0]['revision'], 2)
        self.assertFalse(changed.json()['topics'][1]['active'])
        body['topics'][0]['name'] = 'Normalization'
        renamed = self.client.patch(f"/study/subjects/{subject['id']}", json=body).json()
        self.assertEqual(renamed['topics'][0]['revision'], 2)

    def test_study_conversation_starts_with_topic_and_shares_subject_progress(self):
        subject = self.create_subject()
        topic = subject['topics'][0]
        response = self.client.post(f"/study/subjects/{subject['id']}/topics/{topic['id']}/conversations")
        self.assertEqual(response.status_code, 201, response.text)
        session = self.client.get(f"/study/conversations/{response.json()['conversation_id']}").json()
        self.assertEqual(session['topic']['name'], 'Normalization')
        self.assertIn('Explain', session['question'])
        self.assertEqual(session['subject']['exam_type'], 'written')
        self.assertEqual(self.client.get(f"/conversations/{session['conversation_id']}").json()['draft'], '')

    def test_image_upload_is_reviewed_before_becoming_reference_material(self):
        import io
        from PIL import Image
        image = io.BytesIO()
        Image.new('RGB', (64, 64), 'white').save(image, format='PNG')
        subject = self.create_subject()
        async def extract(request):
            self.requests.append(json.loads(request.content))
            return httpx2.Response(200, json={'message': {'content': json.dumps({'text': '3NF reference text'})}, 'done': True})
        self.handler = extract
        with self.client.websocket_connect('/events', headers=ORIGIN) as socket:
            headers = {**ORIGIN, 'X-Session-ID': receive_type(socket, 'session.ready')['session_id'], 'Content-Type': 'application/octet-stream'}
            response = self.client.post(f"/study/subjects/{subject['id']}/uploads?name=notes.png&role=reference", headers=headers, content=image.getvalue())
        self.assertEqual(response.status_code, 201, response.text)
        upload = response.json()
        self.assertFalse(upload['approved'])
        self.assertEqual(upload['text'], '[Page 1]\n3NF reference text')
        self.assertTrue(self.requests[0]['messages'][0]['images'])
        approved = self.client.patch(f"/study/uploads/{upload['id']}", json={'text': 'Reviewed definition of 3NF', 'topic_ids': [subject['topics'][0]['id']], 'topics': []})
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertTrue(approved.json()['approved'])
        saved = self.client.get(f"/study/subjects/{subject['id']}").json()['uploads'][0]
        self.assertEqual(saved['text'], 'Reviewed definition of 3NF')

    def study_conversation(self, subject):
        return self.client.post(f"/study/subjects/{subject['id']}/topics/{subject['topics'][0]['id']}/conversations").json()['conversation_id']

    def send(self, socket, conversation, text, request_id, action='answer'):
        headers = {**ORIGIN, 'X-Session-ID': receive_type(socket, 'session.ready')['session_id']}
        return self.client.post('/chat', headers=headers, json={'conversation_id': conversation, 'request_id': request_id, 'messages': [{'role': 'user', 'content': text}], 'study_action': action})

    def test_unsupported_model_judgment_cannot_establish_a_knowledge_gap(self):
        subject = self.create_subject()
        conversation = self.study_conversation(subject)
        async def unsupported(request):
            self.requests.append(json.loads(request.content))
            return httpx2.Response(200, json={'message': {'content': json.dumps({'feedback': 'Wrong answer.', 'question': 'Explain normalization.', 'judgment': 'needs_revision', 'confident': True, 'sources': ['invented-source'], 'gaps': ['3NF misunderstood']})}, 'done': True})
        self.handler = unsupported
        with self.client.websocket_connect('/events', headers=ORIGIN) as socket:
            response = self.send(socket, conversation, '3NF needs three columns.', 'unsupported')
        self.assertEqual(json.loads(response.text.splitlines()[-1])['type'], 'chat.done', response.text)
        topic = self.client.get(f"/study/subjects/{subject['id']}").json()['topics'][0]
        self.assertEqual(topic['judgment'], 'not_assessed')
        self.assertEqual(topic['assessment']['gaps'], [])
        self.assertTrue(topic['assessment']['provisional'])
        self.assertIn('Provisional', self.client.get(f'/conversations/{conversation}').json()['messages'][-1]['content'])
        self.assertEqual(self.requests[0]['messages'][0]['role'], 'system')

    def reference(self, subject):
        response = self.client.post(f"/study/subjects/{subject['id']}/references", json={'name': 'DBMS notes', 'text': '3NF: every nontrivial X -> A has X a superkey or A a prime attribute.', 'topic_ids': [subject['topics'][0]['id']]})
        self.assertEqual(response.status_code, 201, response.text)
        upload = response.json()
        self.client.patch(f"/study/uploads/{upload['id']}", json={'text': upload['text'], 'topic_ids': [subject['topics'][0]['id']]})
        return upload['id']

    def test_independent_followup_establishes_progress_but_hinted_answers_do_not(self):
        subject = self.create_subject()
        source = self.reference(subject)
        conversation = self.study_conversation(subject)
        async def supported(request):
            self.requests.append(json.loads(request.content))
            return httpx2.Response(200, content=json.dumps({'message': {'content': json.dumps({'feedback': 'Correct.', 'question': 'Apply 3NF to an example.', 'judgment': 'demonstrated', 'confident': True, 'sources': [source], 'gaps': []})}, 'done': True}) + '\n')
        self.handler = supported
        for request_id, action in [('explanation', 'answer'), ('teach', 'explain'), ('hinted', 'answer'), ('fresh', 'answer')]:
            with self.client.websocket_connect('/events', headers=ORIGIN) as socket:
                response = self.send(socket, conversation, 'My answer ' + request_id, request_id, action)
                self.assertEqual(json.loads(response.text.splitlines()[-1])['type'], 'chat.done', response.text)
            topic = self.client.get(f"/study/subjects/{subject['id']}").json()['topics'][0]
            if request_id in ('explanation', 'hinted'):
                self.assertEqual(topic['judgment'], 'partial')
                self.assertEqual(self.client.get(f'/study/conversations/{conversation}').json()['hinted'], int(request_id == 'teach'))
        self.assertEqual(topic['judgment'], 'demonstrated')
        self.assertEqual(len(topic['history']), 4)
        self.assertEqual(topic['history'][2]['result']['judgment'], 'not_assessed')
        other = self.study_conversation(subject)
        self.assertEqual(self.client.get(f'/study/conversations/{other}').json()['topic']['judgment'], 'demonstrated')

    def test_deleting_reference_invalidates_its_assessments(self):
        subject = self.create_subject()
        source = self.reference(subject)
        conversation = self.study_conversation(subject)
        async def supported(request):
            return httpx2.Response(200, content=json.dumps({'message': {'content': json.dumps({'feedback': 'Incorrect.', 'question': 'Explain 3NF.', 'judgment': 'needs_revision', 'confident': True, 'sources': [source], 'gaps': ['3NF definition']})}, 'done': True}) + '\n')
        self.handler = supported
        with self.client.websocket_connect('/events', headers=ORIGIN) as socket:
            self.send(socket, conversation, 'Three columns', 'wrong')
        self.assertEqual(self.client.delete(f'/study/uploads/{source}').status_code, 204)
        topic = self.client.get(f"/study/subjects/{subject['id']}").json()['topics'][0]
        self.assertEqual(topic['judgment'], 'not_assessed')
        self.assertTrue(topic['needs_reassessment'])

    def test_deleting_conversation_removes_evidence_and_marks_topic_for_reassessment(self):
        subject = self.create_subject()
        source = self.reference(subject)
        conversation = self.study_conversation(subject)
        async def supported(request):
            return httpx2.Response(200, content=json.dumps({'message': {'content': json.dumps({'feedback': 'Incorrect.', 'question': 'Explain 3NF.', 'judgment': 'needs_revision', 'confident': True, 'sources': [source], 'gaps': ['3NF definition']})}, 'done': True}) + '\n')
        self.handler = supported
        with self.client.websocket_connect('/events', headers=ORIGIN) as socket:
            self.send(socket, conversation, 'Three columns', 'wrong')
        self.client.delete(f'/conversations/{conversation}')
        topic = self.client.get(f"/study/subjects/{subject['id']}").json()['topics'][0]
        self.assertEqual(topic['history'], [])
        self.assertEqual(topic['judgment'], 'not_assessed')
        self.assertTrue(topic['needs_reassessment'])

    def test_invented_followup_schema_is_replaced_with_self_contained_application(self):
        subject = self.create_subject()
        source = self.reference(subject)
        conversation = self.study_conversation(subject)
        async def invented(request):
            return httpx2.Response(200, content=json.dumps({'message': {'content': json.dumps({'feedback': 'Correct.', 'question': 'Given R(OrderID, CustomerID, ProductID), is it in 3NF?', 'judgment': 'partial', 'confident': True, 'sources': [source], 'gaps': []})}, 'done': True}) + '\n')
        self.handler = invented
        with self.client.websocket_connect('/events', headers=ORIGIN) as socket:
            self.send(socket, conversation, '3NF concerns functional dependencies.', 'invented-question')
        session = self.client.get(f'/study/conversations/{conversation}').json()
        self.assertNotIn('OrderID', session['question'])
        self.assertIn('assumptions', session['question'])

    def test_interrupted_feedback_keeps_answer_without_progress_or_automatic_retry(self):
        subject = self.create_subject()
        conversation = self.study_conversation(subject)
        async def incomplete(request):
            self.requests.append(json.loads(request.content))
            return httpx2.Response(200, content=json.dumps({'message': {'content': '{"feedback":'}, 'done': False}) + '\n')
        self.handler = incomplete
        with self.client.websocket_connect('/events', headers=ORIGIN) as socket:
            first = self.send(socket, conversation, 'My retained answer', 'interrupted')
        self.assertEqual(json.loads(first.text.splitlines()[-1])['type'], 'chat.error')
        messages = self.client.get(f'/conversations/{conversation}').json()['messages']
        self.assertEqual(messages[0]['content'], 'My retained answer')
        self.assertEqual(messages[1]['content'], '')
        self.assertEqual(messages[1]['status'], 'failed')
        self.assertEqual(self.client.get(f"/study/subjects/{subject['id']}").json()['topics'][0]['history'], [])
        with self.client.websocket_connect('/events', headers=ORIGIN) as socket:
            self.send(socket, conversation, 'My retained answer', 'interrupted')
        self.assertEqual(len(self.requests), 1)
        self.client.__exit__(None, None, None)
        self.client = self.open_client()
        self.assertIn('Explain Normalization in your own words', self.client.get(f'/study/conversations/{conversation}').json()['question'])
        self.assertEqual(len(self.requests), 1)

    def test_deleting_subject_removes_its_study_conversations_and_uploads(self):
        subject = self.create_subject()
        source = self.reference(subject)
        conversation = self.study_conversation(subject)
        self.assertEqual(self.client.delete(f"/study/subjects/{subject['id']}").status_code, 204)
        self.assertEqual(self.client.get(f"/study/subjects/{subject['id']}").status_code, 404)
        self.assertEqual(self.client.get(f'/conversations/{conversation}').status_code, 404)
        self.assertEqual(self.client.delete(f'/study/uploads/{source}').status_code, 404)

    def test_printed_pdf_extracts_selected_page_without_ollama(self):
        # A literal independent PDF fixture: one page with a known topic list.
        stream = b'BT /F1 16 Tf 50 750 Td (DBMS syllabus: Normalization and Transactions) Tj ET'
        objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
        pdf, offsets = b'%PDF-1.4\n', [0]
        for index, obj in enumerate(objects, 1):
            offsets.append(len(pdf))
            pdf += str(index).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
        xref = len(pdf)
        pdf += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
        pdf += f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode()
        subject = self.create_subject()
        with self.client.websocket_connect('/events', headers=ORIGIN) as socket:
            headers = {**ORIGIN, 'X-Session-ID': receive_type(socket, 'session.ready')['session_id']}
            response = self.client.post(f"/study/subjects/{subject['id']}/uploads?name=syllabus.pdf&role=syllabus&pages=1", headers=headers, content=pdf)
            invalid = self.client.post(f"/study/subjects/{subject['id']}/uploads?name=syllabus.pdf&role=syllabus&pages=2", headers=headers, content=pdf)
        self.assertEqual(response.status_code, 201, response.text)
        self.assertIn('DBMS syllabus: Normalization and Transactions', response.json()['text'])
        self.assertEqual(response.json()['pages'], [1])
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(len(self.requests), 0)
