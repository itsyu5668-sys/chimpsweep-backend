const { createClient } = require('@supabase/supabase-js');
const { WebSocket } = require('ws');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  realtime: {
    transport: WebSocket,
  },
});

module.exports = supabase;
