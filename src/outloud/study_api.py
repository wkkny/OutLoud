"""Study HTTP interface; model work uses the same live-client ownership as chat."""
import asyncio
from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel, Field
from typing import Literal
import httpx2
from fastapi.responses import Response
from urllib.parse import quote
from .study import TopicInput
from .study_uploads import MAX_FILE_BYTES
from .study import SubjectInput
from .chat import ChatCapacityBusy


class UploadReview(BaseModel):
    text: str = Field(min_length=1, max_length=50000)
    topic_ids: list[str] = Field(default_factory=list, max_length=200)
    topics: list[TopicInput] = Field(default_factory=list, max_length=200)


class ReferenceInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=50000)
    topic_ids: list[str] = Field(default_factory=list, max_length=200)


def study_router(app, complete_write, require_client):
    router = APIRouter(prefix='/study')

    async def read(method, *args):
        try:
            return await asyncio.to_thread(method, *args)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    @router.get('/subjects')
    async def subjects():
        return await read(app.state.study.list)

    @router.post('/subjects', status_code=201)
    async def create_subject(body: SubjectInput):
        return await complete_write(read(app.state.study.create, body))

    @router.get('/subjects/{subject_id}')
    async def subject(subject_id: str):
        return await read(app.state.study.get, subject_id)

    @router.patch('/subjects/{subject_id}')
    async def update_subject(subject_id: str, body: SubjectInput):
        return await complete_write(read(app.state.study.update, subject_id, body))

    @router.post('/subjects/{subject_id}/topics/{topic_id}/conversations', status_code=201)
    async def start_conversation(subject_id: str, topic_id: str):
        return await complete_write(read(app.state.study.start_conversation, subject_id, topic_id))

    @router.get('/conversations/{conversation_id}')
    async def study_conversation(conversation_id: str):
        return await read(app.state.study.session, conversation_id)

    @router.post('/subjects/{subject_id}/uploads', status_code=201)
    async def upload(subject_id: str, request: Request, name: str, role: Literal['syllabus', 'reference'], pages: str = '', session_id=Depends(require_client)):
        await read(app.state.study.get, subject_id)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > MAX_FILE_BYTES:
                raise HTTPException(413, 'Choose a file of at most 8 MB.')
        try:
            selected = [int(page.strip()) for page in pages.split(',') if page.strip()]
            text, page_count, selected = await app.state.study_extractor.extract(bytes(data), selected)
            result = await complete_write(read(app.state.study.add_upload, subject_id, name, role, bytes(data), text, selected))
            return {**result, 'page_count': page_count}
        except ChatCapacityBusy as error:
            raise HTTPException(429, str(error)) from error
        except (ValueError, KeyError, TypeError) as error:
            raise HTTPException(422, str(error)) from error
        except (httpx2.HTTPError, TimeoutError) as error:
            raise HTTPException(503, 'Extraction could not complete. Check Ollama and try a smaller page selection.') from error

    @router.patch('/uploads/{upload_id}')
    async def approve_upload(upload_id: str, body: UploadReview):
        return await complete_write(read(app.state.study.approve_upload, upload_id, body.text, body.topic_ids, body.topics))

    @router.post('/subjects/{subject_id}/references', status_code=201)
    async def reference(subject_id: str, body: ReferenceInput):
        async def commit():
            uploaded = await read(app.state.study.add_upload, subject_id, body.name, 'reference', body.text.encode(), body.text, [])
            return await read(app.state.study.approve_upload, uploaded['id'], body.text, body.topic_ids, [])
        return await complete_write(commit())

    @router.delete('/uploads/{upload_id}', status_code=204)
    async def delete_upload(upload_id: str):
        await complete_write(read(app.state.study.delete_upload, upload_id))

    @router.delete('/subjects/{subject_id}', status_code=204)
    async def delete_subject(subject_id: str):
        async def commit():
            ids = await read(app.state.study.delete_subject, subject_id)
            for conversation_id in ids:
                app.state.chat.cancel_conversation(conversation_id)
                await asyncio.to_thread(app.state.runtime.transcripts.delete_conversation, conversation_id)
        await complete_write(commit())

    @router.get('/uploads/{upload_id}/original')
    async def original_upload(upload_id: str):
        name, data = await read(app.state.study.original_upload, upload_id)
        return Response(data, media_type='application/octet-stream', headers={
            'Content-Disposition': "attachment; filename*=UTF-8''" + quote(name, safe=''),
            'X-Content-Type-Options': 'nosniff',
        })

    return router
