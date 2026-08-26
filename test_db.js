import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);
async function run() {
  const { data, error } = await supabase.from('questions').select('*').limit(1);
  if (data && data.length > 0) {
    console.log("questions keys:", Object.keys(data[0]));
  } else {
    console.log("questions error:", error ? error.message : "Empty table");
  }
}
run();
