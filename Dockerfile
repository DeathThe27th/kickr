# Kickr backend (the Brain) for Render.
# Python for FastAPI + Node for the Solana receipt committer that the backend
# shells out to (chain/scripts/commit-receipt.ts via `npx tsx`). Build context
# must be the REPO ROOT so both backend/ and chain/ are available.
FROM python:3.11-slim

# Node 20 for the receipt committer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first (layer cache).
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Chain deps (installs tsx + @solana/web3.js for the receipt committer).
COPY chain/package.json chain/package-lock.json chain/
RUN cd chain && npm ci

# App source.
COPY backend/ backend/
COPY chain/ chain/

WORKDIR /app/backend
ENV PYTHONUNBUFFERED=1
# Render provides $PORT.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
