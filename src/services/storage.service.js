import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';

let supabase = null;
if (env.supabase.url && env.supabase.key) {
  try {
    supabase = createClient(env.supabase.url, env.supabase.key);
  } catch (err) {
    console.warn('[STORAGE] Failed to initialize Supabase client:', err.message);
  }
}

/**
 * Uploads a file buffer/file stream to Supabase Storage if configured.
 * Returns the public URL if uploaded to Supabase, or null if local storage should be used.
 */
export async function uploadToSupabase(file, folder = 'general') {
  if (!supabase) return null;

  try {
    const bucket = env.supabase.bucket;
    const extension = path.extname(file.originalname) || '.png';
    const filePath = `${folder}/${Date.now()}-${Math.random().toString(36).substring(2, 9)}${extension}`;
    const fileBuffer = fs.readFileSync(file.path);

    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filePath, fileBuffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (error) {
      console.warn('[STORAGE] Supabase Storage upload error, using local fallback:', error.message);
      return null;
    }

    const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(data.path);
    return publicData?.publicUrl || null;
  } catch (err) {
    console.warn('[STORAGE] Unexpected error uploading to Supabase:', err.message);
    return null;
  }
}

export default { uploadToSupabase };
