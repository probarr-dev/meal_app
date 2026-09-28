FROM python:3.12-slim

WORKDIR /app
# Only for push notifications; the app runs without it.
RUN pip install --no-cache-dir cryptography
COPY server.py auth.py push.py seed.py schema.sql ./
COPY static/ ./static/

ENV MEALPLAN_DB=/data/mealplan.db
ENV PORT=8080
VOLUME ["/data"]
EXPOSE 8080

CMD ["python", "server.py"]
