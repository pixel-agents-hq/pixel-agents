import { call, put, takeLatest } from 'redux-saga/effects'

import { healthFailed, healthRequested, healthSucceeded } from './serverSlice'
import type { HealthInfo } from './serverSlice'

export const HEALTH_ENDPOINT = '/api/health'

export function* fetchHealth() {
  try {
    const response: Response = yield call(fetch, HEALTH_ENDPOINT)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const health: HealthInfo = yield call([response, response.json])
    yield put(healthSucceeded(health))
  } catch (error) {
    yield put(healthFailed(error instanceof Error ? error.message : String(error)))
  }
}

export function* serverSaga() {
  yield takeLatest(healthRequested.type, fetchHealth)
}
