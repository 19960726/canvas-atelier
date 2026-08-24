import {
  AudioLines,
  Bot,
  Boxes,
  Brush,
  Clapperboard,
  Columns2,
  CirclePlay,
  FileChartColumn,
  FileText,
  Film,
  Image,
  ImageUp,
  Images,
  MessageSquareText,
  Music2,
  PanelTop,
  PenTool,
  PersonStanding,
  ScanLine,
  ScanSearch,
  SlidersHorizontal,
  Table2,
  WandSparkles,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CanvasModuleType } from '@agent-canvas/domain';

const moduleIconByType: Record<CanvasModuleType, LucideIcon> = {
  image_input: Image,
  upload_image: ImageUp,
  video_input: Clapperboard,
  canvas_library: Images,
  text_prompt: MessageSquareText,
  image_generation: WandSparkles,
  video_generation: Film,
  image_editor: SlidersHorizontal,
  drawing_mask: Brush,
  local_redraw: PenTool,
  image_compare: Columns2,
  openpose: PersonStanding,
  reverse_agent: ScanSearch,
  skill_agent: Bot,
  detail_page_agent: PanelTop,
  storyboard_sheet: Table2,
  storyboard_chart: FileChartColumn,
  line_art_material: ScanLine,
  comfy_workflow: Workflow,
  music_generation: Music2,
  speech_generation: AudioLines,
  result_output: Boxes,
  video_result: CirclePlay,
  reverse_result: FileText,
};

export function resolveCanvasModuleIcon(moduleType: CanvasModuleType): LucideIcon {
  return moduleIconByType[moduleType];
}
