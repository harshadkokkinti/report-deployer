-- Complaint Report Deployer — schema additions to the shared olly-backend Supabase project.
-- Prefixed with complaint_report_ so nothing collides with existing olly-backend tables.
-- Run this once in the Supabase SQL editor (or `supabase db execute -f db/complaint_reports.sql`).

create extension if not exists pgcrypto;

create table if not exists complaint_report_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);

create table if not exists complaint_report_reports (
  id text primary key,                      -- job id, e.g. job_a1b2c3d4
  place jsonb not null,                      -- { title, address }
  image_url text not null,
  requested_by_id uuid references complaint_report_users(id) on delete set null,
  requested_by_name text not null,
  requested_by_email text not null,
  status text not null default 'running' check (status in ('running', 'ready', 'failed')),
  report_url text,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  took_ms integer
);

create index if not exists complaint_report_reports_started_at_idx
  on complaint_report_reports (started_at desc);

-- RLS on, no policies: only the server (using the service_role key, which bypasses RLS)
-- ever touches these tables. The browser never talks to Supabase directly.
alter table complaint_report_users enable row level security;
alter table complaint_report_reports enable row level security;
