import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router';

interface NotFoundPageProps {
  message?: string;
  homeTo?: string;
}

export function NotFoundPage({ message = '找不到這個頁面', homeTo = '/' }: NotFoundPageProps) {
  return (
    <Box sx={{ flex: 1, minHeight: '50vh', display: 'grid', placeItems: 'center' }}>
      <Box sx={{ textAlign: 'center' }}>
        <Typography variant="subtitle1" sx={{ mb: 2 }}>
          {message}
        </Typography>
        <Button variant="outlined" component={RouterLink} to={homeTo}>
          回到首頁
        </Button>
      </Box>
    </Box>
  );
}
