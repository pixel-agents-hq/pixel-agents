import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

interface FormFieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function FormField({ label, hint, children }: FormFieldProps) {
  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography sx={{ fontSize: 11, fontWeight: 500, color: 'text.secondary', mb: 0.75 }}>
        {label}
      </Typography>
      {children}
      {hint && (
        <Typography sx={{ fontSize: 11, color: 'text.disabled', mt: 0.5 }}>{hint}</Typography>
      )}
    </Box>
  );
}
