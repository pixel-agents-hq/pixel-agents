import { configureStore } from '@reduxjs/toolkit'
import createSagaMiddleware from 'redux-saga'

import { serverReducer } from '../features/server/serverSlice'
import { rootSaga } from './rootSaga'

export function createAppStore() {
  const sagaMiddleware = createSagaMiddleware()
  const store = configureStore({
    reducer: { server: serverReducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(sagaMiddleware),
  })
  sagaMiddleware.run(rootSaga)
  return store
}

export const store = createAppStore()

export type AppStore = ReturnType<typeof createAppStore>
export type RootState = ReturnType<AppStore['getState']>
export type AppDispatch = AppStore['dispatch']
