FROM python:3.12-slim

WORKDIR /app
COPY server.py seed.py schema.sql ./
COPY static/ ./static/

# No pip install — stdlib only, so there's no dependency tree to rot.
ENV MEALPLAN_DB=/data/mealplan.db
ENV PORT=8080
VOLUME ["/data"]
EXPOSE 8080

CMD ["python", "server.py"]
