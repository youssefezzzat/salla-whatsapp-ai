-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Helper function for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. Customers Table
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) NOT NULL,
    salla_customer_id VARCHAR(100),
    name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique Indexes for Customers (handles nulls correctly in Postgres)
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_phone ON customers (phone);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_salla ON customers (salla_customer_id) WHERE salla_customer_id IS NOT NULL;

CREATE TRIGGER trg_update_customers_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. Conversations Sessions Table
CREATE TABLE IF NOT EXISTS conversations_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'ai',
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    department VARCHAR(30),
    assigned_agent_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_session_status CHECK (status IN ('ai', 'human', 'human_handoff')),
    CONSTRAINT chk_session_department CHECK (department IN ('sales', 'support', 'human'))
);

CREATE TRIGGER trg_update_sessions_updated_at
BEFORE UPDATE ON conversations_sessions
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 3. Customer Memory Table
CREATE TABLE IF NOT EXISTS customer_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    context TEXT NOT NULL,
    version INT DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_customer_memory UNIQUE (customer_id)
);

CREATE TRIGGER trg_update_memory_updated_at
BEFORE UPDATE ON customer_memory
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 4. Idempotency Logs Table (with TTL & Partial Unique Index)
CREATE TABLE IF NOT EXISTS idempotency_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(100) NOT NULL,
    signature TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMETAMPTZ NOT NULL,
    CONSTRAINT chk_idempotency_expires CHECK (expires_at > created_at)
);

-- Partial unique index for active idempotency records (efficient deduplication)
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_active_event ON idempotency_logs (event_id) WHERE expires_at > NOW();

-- Index for TTL cleanup queries
CREATE INDEX IF NOT EXISTS idx_idempotency_ttl ON idempotency_logs (expires_at);
