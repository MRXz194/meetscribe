FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Model nằm trong image để container chạy được không cần internet
COPY scripts/download_models.py scripts/
RUN python scripts/download_models.py

COPY pipeline.py deepgram_engine.py silence.py app.py ./

ENV NUM_THREADS=4 \
    CORS_ORIGINS=http://localhost:3000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
