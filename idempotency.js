import { supabase } from './supabase-client.js';

export async function verifyIdempotency(eventId, signature) {
  try {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    const { data, error } = await supabase
      .from('idempotency_logs')
      .insert([{ event_id: eventId, signature: signature, expires_at: expiresAt }])
      .select('id');

    if (error) {
      if (error.code === '23505') return false; // حدث مكرر
      throw error;
    }

    return data && data.length > 0;
  } catch (err) {
    console.error("Idempotency error:", err);
    throw err;
  }
}