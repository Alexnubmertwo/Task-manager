# Smart Notes

Локальное веб-приложение для заметок с AI-анализом через Groq.

## Запуск локально

Требуется Node.js 20.12 или новее.

1. Скопируйте `.env.example` в `.env`.
2. В `.env` укажите новый `GROQ_API_KEY`. Ключ хранится только на сервере и не должен попадать в Git.
3. Запустите приложение:

```powershell
npm start
```

Откройте http://localhost:4173.

## Railway

Подключите GitHub-репозиторий к Railway. Команда запуска: `npm start`. В Variables добавьте `GROQ_API_KEY` и при необходимости `GROQ_MODEL` (`openai/gpt-oss-20b`). Railway назначает `PORT` автоматически. Health-check path: `/health`.
