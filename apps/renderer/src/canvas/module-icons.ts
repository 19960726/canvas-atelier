import {
  Box,
  FileSearch,
  FileText,
  Image,
  Library,
  MessageSquare,
  Pencil,
  Search,
  Sparkles,
  Upload,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CanvasModuleType } from '@agent-canvas/domain';

const moduleIconByType: Record<CanvasModuleType, LucideIcon> = {
  image_input: Image,
  upload_image: Upload,
  video_input: Video,
  canvas_library: Library,
  text_prompt: MessageSquare,
  image_generation_v1: Sparkles,
  image_generation_v2: Sparkles,
  image_editor: Pencil,
  openpose: Search,
  reverse_agent: Search,
  skill_agent: Sparkles,
  detail_page_agent: FileSearch,
  video_analysis: Video,
  line_art_material: FileText,
  result_output: Box,
};

export function resolveCanvasModuleIcon(iconKey: string): LucideIcon {
  return moduleIconByType[iconKey as CanvasModuleType] ?? Box;
}
