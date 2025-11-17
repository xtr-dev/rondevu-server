-- Migration: Add secret column to offers table
-- Allows offers to be protected with a secret that answerers must provide

ALTER TABLE offers ADD COLUMN secret TEXT;
