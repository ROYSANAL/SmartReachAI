#!/bin/sh

# Start all services in background
nohup npm run linkedin &
nohup npm run email &
nohup npx tsx --env-file .env setup-gmail-pubsub.ts &
nohup npm run start &

# Wait for all background processes
wait
