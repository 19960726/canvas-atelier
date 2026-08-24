export type TransientPopoverId =
  | 'knowledge'
  | 'model'
  | 'reference'
  | 'quick-insert'
  | 'project-menu';

export type TransientPopoverState = TransientPopoverId | null;

export type TransientPopoverAction =
  | { readonly type: 'open'; readonly id: TransientPopoverId }
  | { readonly type: 'toggle'; readonly id: TransientPopoverId }
  | { readonly type: 'close-external' }
  | { readonly type: 'internal-interaction' };

export function reduceTransientPopover(
  state: TransientPopoverState,
  action: TransientPopoverAction,
): TransientPopoverState {
  if (action.type === 'open') return action.id;
  if (action.type === 'toggle') return state === action.id ? null : action.id;
  if (action.type === 'close-external') return null;
  return state;
}
