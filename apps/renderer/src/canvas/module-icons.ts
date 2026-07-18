import {
  Aperture,
  Bot,
  Boxes,
  Clapperboard,
  FileVideo,
  Image,
  ImageUp,
  Images,
  MessageSquareText,
  PanelTop,
  PenTool,
  PersonStanding,
  ScanSearch,
  SlidersHorizontal,
  WandSparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CanvasModuleType } from '@agent-canvas/domain';

const moduleIconByType: Record<CanvasModuleType, LucideIcon> = {
  image_input: Image,
  upload_image: ImageUp,
  video_input: Clapperboard,
  canvas_library: Images,
  text_prompt: MessageSquareText,
  image_generation_v1: WandSparkles,
  image_generation_v2: Aperture,
  image_editor: SlidersHorizontal,
  openpose: PersonStanding,
  reverse_agent: ScanSearch,
  skill_agent: Bot,
  detail_page_agent: PanelTop,
  video_analysis: FileVideo,
  line_art_material: PenTool,
  result_output: Boxes,
};

export function resolveCanvasModuleIcon(moduleType: CanvasModuleType): LucideIcon {
  return moduleIconByType[moduleType];
}
