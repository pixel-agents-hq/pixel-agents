import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Fragment } from 'react';

import { monoFontFamily } from '../theme';

type StepTone = 'plain' | 'send' | 'receive' | 'server';

export interface EventFlowStep {
  label: string;
  value: string;
  detail?: string;
  tone: StepTone;
}

const TONES: Record<
  StepTone,
  { label: string; value: string; background: string; border: string }
> = {
  plain: {
    label: 'text.disabled',
    value: 'text.secondary',
    background: '#111117',
    border: '#2a2a38',
  },
  send: {
    label: 'primary.main',
    value: 'primary.light',
    background: 'rgba(91,48,214,0.08)',
    border: 'rgba(91,48,214,0.25)',
  },
  receive: {
    label: 'success.main',
    value: 'success.main',
    background: 'rgba(34,197,94,0.06)',
    border: 'rgba(34,197,94,0.2)',
  },
  server: {
    label: 'text.disabled',
    value: 'text.disabled',
    background: '#111117',
    border: '#1e1e2a',
  },
};

/** 把這個表單送出後，前端與伺服器之間依序發生的訊息畫出來。 */
export function EventFlow({ steps }: { steps: EventFlowStep[] }) {
  return (
    <Box
      sx={{
        p: 1.75,
        mb: 3.5,
        bgcolor: '#0d0d13',
        border: 1,
        borderColor: 'divider',
        borderRadius: '4px',
      }}
    >
      <Typography
        sx={{
          fontSize: 10,
          color: 'text.disabled',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          mb: 1.25,
        }}
      >
        WS Event Flow
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}>
        {steps.map((step, index) => {
          const tone = TONES[step.tone];
          return (
            <Fragment key={`${step.label}-${step.value}`}>
              {index > 0 && <Box sx={{ px: 0.75, color: 'text.disabled', fontSize: 11 }}>→</Box>}
              <Box
                sx={{
                  px: 1.25,
                  py: 0.75,
                  textAlign: 'center',
                  bgcolor: tone.background,
                  border: `1px solid ${tone.border}`,
                  borderRadius: '3px',
                }}
              >
                <Typography sx={{ fontSize: 9, color: tone.label, mb: '2px' }}>
                  {step.label}
                </Typography>
                <Typography sx={{ fontFamily: monoFontFamily, fontSize: 10, color: tone.value }}>
                  {step.value}
                </Typography>
                {step.detail && (
                  <Typography
                    sx={{
                      fontFamily: monoFontFamily,
                      fontSize: 9,
                      color: 'text.disabled',
                      mt: '2px',
                    }}
                  >
                    {step.detail}
                  </Typography>
                )}
              </Box>
            </Fragment>
          );
        })}
      </Box>
    </Box>
  );
}
