SELECT format('CREATE DATABASE %I OWNER %I', 'event_service_database', 'admin')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'event_service_database'
)\gexec
