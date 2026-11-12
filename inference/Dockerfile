# Approx AI inference server (GPU). Build from the repository root:
#   docker build -f inference/Dockerfile -t approx-inference .
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime
WORKDIR /app
COPY inference/requirements.txt /app/inference/requirements.txt
RUN pip install --no-cache-dir -r /app/inference/requirements.txt
COPY approx_artifacts /app/approx_artifacts
COPY inference/server.py /app/inference/server.py
COPY backend/config/models.json /app/backend/config/models.json
RUN useradd -r -u 10001 approx && mkdir -p /models /hf && chown approx /hf
USER approx
ENV APPROX_MODELS_DIR=/models INFERENCE_HOST=0.0.0.0 INFERENCE_PORT=8000 HF_HOME=/hf PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "/app/inference/server.py"]
