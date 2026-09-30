import {resourceJson} from './resource-snapshot';
import { createContext, useContext, useEffect, useState } from "react";
export interface Character {
  id: string;
  name: string;
  first_name: string;
  english_name: string;
  color: string;
  gradient_colors?: [string, string];
  details: Record<string, string>;
  portrait: string | null;
  avatar: string | null;
  signature: string | null;
}
export interface Category {
  id: string;
  name: string;
  parent_id: string | null;
  script_count: number;
}
export interface Catalog {
  story_titles?: Record<string,string>;
  resource_revision?: string | number | null;
  speaker_avatars?: { id: string; name: string; aliases: string[]; avatar: string }[];
  build_id: string;
  updates_path?: string;
  pending_text_count?: number;
  base_path: string;
  characters: Character[];
  categories: Category[];
  entry_count: number;
  script_count: number;
  lists: Record<string, string>;
  filter_characters?: { id: string; name: string; stamp_unselected?: string | null; stamp_selected?: string | null }[];
}
export interface Entry {
  id: string;
  script_id: string;
  title: string;
  category_id: string;
  character_ids: string[];
  order: number;
  group_id: string;
  group_title: string;
  group_order: number;
  release_at?: number | null;
  text_updated_at?: number | null;
  support_rarity?: string | null;
  support_attribute?: string | null;
  group_image: string | null;
  group_images?: { url: string; label: string; aspect_ratio?: number | null; preview_crop?: string | null }[];
  text_status: string;
  line_count: number;
}
export interface ChapterVoices { source_sha256: string | null; lines: { record_index: number; text: string; speaker: string; clips: { url: string; label: string }[] }[] }
export interface Chapter {
  voices?: ChapterVoices;
  metadata_pending?: boolean;
  group_images?: Entry["group_images"];
  script_id: string;
  entries: Entry[];
  csv_path: string | null;
  text_status: string;
  line_count: number;
  translated_line_count: number;
  voice_event_count: number;
}
export const CatalogContext = createContext<Catalog | null>(null);
export function useCatalog() {
  const value = useContext(CatalogContext);
  if (!value) throw new Error("Catalog missing");
  return value;
}
export function useJson<T>(url: string) {
  const [result, setResult] = useState<{
    url: string;
    data?: T;
    error?: string;
  }>({ url });
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const load = () => resourceJson<T>(url, { signal: controller.signal })
      .then((data: T) => setResult({ url, data }))
      .catch((e) => {
        if (e.name !== "AbortError")
          { setResult({ url, error: "资料暂时无法加载，请稍后重试。" });
            if (url === "/catalog/manifest.json") retry = setTimeout(load, 15000); }
      });
    load();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [url]);
  return result.url === url ? result : { url };
}
