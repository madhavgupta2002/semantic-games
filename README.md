# Semantic Games

Word guessing by meaning: guesses are scored by embedding similarity using Amazon Bedrock. Express backend plus a single-page frontend.

## Run

Requires Node 20.6+.

```bash
npm install
cp .env.example .env   # add a NEW Bedrock API key and a long random DAILY_SECRET
npm start              # http://localhost:3000
```

`.env` is gitignored. Never commit API keys.
