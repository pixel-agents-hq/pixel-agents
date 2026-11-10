import Box from '@mui/material/Box';

import { roleColors } from '../theme';

type BadgeRole = keyof typeof roleColors;

interface RoleBadgeProps {
  role: BadgeRole;
  label?: string;
}

export function RoleBadge({ role, label }: RoleBadgeProps) {
  const colors = roleColors[role];
  return (
    <Box
      component="span"
      sx={{
        flexShrink: 0,
        fontSize: 9,
        lineHeight: 1.4,
        px: label ? '6px' : '5px',
        borderRadius: '2px',
        color: colors.color,
        bgcolor: colors.background,
        border: `1px solid ${colors.border}`,
      }}
    >
      {label ? `${role} ${label}` : role}
    </Box>
  );
}
