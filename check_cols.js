import "dotenv/config";
import { supabase } from "./src/lib/supabase.js";

async function checkColumns() {
  const { data, error } = await supabase
    .from("library_items")
    .select("*")
    .limit(1);

  if (error) {
    console.error("Error querying library_items:", error.message);
  } else {
    console.log("Sample library item:", data[0]);
  }
}

checkColumns();
