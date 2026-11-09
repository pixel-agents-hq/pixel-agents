import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardActions from '@mui/material/CardActions'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import { useAppDispatch, useAppSelector } from '../../app/hooks'
import { healthRequested } from './serverSlice'

export function ServerStatusCard() {
  const dispatch = useAppDispatch()
  const { request, health, error } = useAppSelector((state) => state.server)

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography variant="h6">後端伺服器</Typography>
          {request === 'ok' && <Chip color="success" size="small" label="連線正常" />}
          {request === 'error' && <Chip color="error" size="small" label="無法連線" />}
          {request === 'loading' && <CircularProgress size={18} />}
        </Stack>
        {health && (
          <Typography variant="body2" color="text.secondary">
            status: {health.status} / pid: {health.pid} / uptime: {health.uptime}s
          </Typography>
        )}
        {error && <Alert severity="error">{error}</Alert>}
      </CardContent>
      <CardActions>
        <Button disabled={request === 'loading'} onClick={() => dispatch(healthRequested())}>
          檢查連線
        </Button>
      </CardActions>
    </Card>
  )
}
