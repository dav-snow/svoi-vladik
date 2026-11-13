FROM python:3.11-slim

WORKDIR /app

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY data/ ./data/
COPY prototypes/ ./prototypes/
COPY scripts/ ./scripts/
# New design frontend served at "/"; built-less static bundle.
COPY frontend-design/dist/ ./frontend-design/dist/
# Licensed place photo pack (manifest + jpgs), served at /assets/places.
COPY assets/ ./assets/

WORKDIR /app/backend

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
