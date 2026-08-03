#!/bin/bash
set -e

echo "Pulling latest changes..."
git pull

echo "Rebuilding and restarting..."
docker compose up -d --build

echo "Cleaning up old images for this project..."
docker image prune -f --filter "label=com.docker.compose.project=sonus"

echo "Done! Checking status..."
docker compose ps
