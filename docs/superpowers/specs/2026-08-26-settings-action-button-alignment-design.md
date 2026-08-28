# Settings Action Button Alignment Design

## Scope

Repair the visible style of `检查连接`, `检查更新`, and local-storage `刷新` without changing their positions, widths, labels, click behavior, loading behavior, or surrounding card layout.

## Approved visual contract

- Keep the existing 34px control height, 9px radius, border, surface colors, 14px refresh icon, 11px label, 6px gap, and current width rules.
- Force the icon and label into one horizontal, centered, non-wrapping row.
- Prevent the icon from shrinking when the button is narrow.
- Preserve the current hover, active, focus-visible, disabled, and spinning states.

## Verification

- Add a regression assertion to the existing final settings-button CSS contract test.
- Observe the new assertion fail before editing production CSS, then pass after the minimal CSS change.
- Run the complete `SettingsDrawer` test file and renderer typecheck/build.
- Capture and inspect the real rendered settings screen at desktop width.

