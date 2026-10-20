import { createBrowserRouter, createMemoryRouter } from 'react-router-dom'
import { routes } from './routes'

export function createAppRouter() {
  return createBrowserRouter(routes)
}

export function createTestRouter(initialEntries: string[]) {
  return createMemoryRouter(routes, { initialEntries })
}
