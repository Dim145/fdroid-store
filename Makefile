.PHONY: help up down build logs ps shell-backend shell-frontend shell-db reindex format

help:
	@echo "Targets:"
	@echo "  up               Build images and start the stack"
	@echo "  down             Stop and remove containers"
	@echo "  build            Rebuild images without starting"
	@echo "  logs             Tail container logs"
	@echo "  ps               List services"
	@echo "  shell-backend    Open a shell inside the backend container"
	@echo "  shell-frontend   Open a shell inside the frontend container"
	@echo "  shell-db         Open psql against the running database"
	@echo "  reindex          Trigger an immediate repo reindex"
	@echo "  format           Run ruff format on the backend"

up:
	docker compose up -d --build

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f --tail=200

ps:
	docker compose ps

shell-backend:
	docker compose exec backend bash

shell-frontend:
	docker compose exec frontend sh

shell-db:
	docker compose exec postgres psql -U $${POSTGRES_USER:-fdroid} -d $${POSTGRES_DB:-fdroid}

reindex:
	docker compose exec backend python -c "import asyncio; from app.services.queue import enqueue_reindex; asyncio.run(enqueue_reindex())"

format:
	cd backend && ruff format .
