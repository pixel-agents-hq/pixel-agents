import { createSlice } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'

export interface HealthInfo {
  status: string
  uptime: number
  pid: number
}

export type ServerRequestState = 'idle' | 'loading' | 'ok' | 'error'

interface ServerState {
  request: ServerRequestState
  health: HealthInfo | null
  error: string | null
}

const initialState: ServerState = {
  request: 'idle',
  health: null,
  error: null,
}

const serverSlice = createSlice({
  name: 'server',
  initialState,
  reducers: {
    healthRequested(state) {
      state.request = 'loading'
      state.error = null
    },
    healthSucceeded(state, action: PayloadAction<HealthInfo>) {
      state.request = 'ok'
      state.health = action.payload
    },
    healthFailed(state, action: PayloadAction<string>) {
      state.request = 'error'
      state.error = action.payload
    },
  },
})

export const { healthRequested, healthSucceeded, healthFailed } = serverSlice.actions
export const serverReducer = serverSlice.reducer
