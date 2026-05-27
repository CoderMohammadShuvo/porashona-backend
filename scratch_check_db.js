import "dotenv/config";
import { supabase } from "./src/lib/supabase.js";

async function checkTables() {
  const { data: assignments, error: err1 } = await supabase
    .from("assignments")
    .select("*")
    .limit(1);

  const { data: submissions, error: err2 } = await supabase
    .from("assignment_submissions")
    .select("*")
    .limit(1);

  console.log("Assignments Table:", { data: assignments, error: err1?.message });
  console.log("Submissions Table:", { data: submissions, error: err2?.message });
}

checkTables();
