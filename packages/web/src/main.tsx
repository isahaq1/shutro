/**
 * The web client's entry: routes, data cache, and the root render.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api.js';
import { AppStore } from './pages/AppStore.js';
import { Home } from './pages/Home.js';
import { Login } from './pages/Login.js';
import { Shell } from './shell/Shell.js';
import { FormPage } from './views/FormPage.js';
import { ModelPage } from './views/ModelPage.js';
import './styles.css';

const root = createRootRoute({ component: () => <Outlet /> });
const login = createRoute({ getParentRoute: () => root, path: '/login', component: Login });
const shell = createRoute({ getParentRoute: () => root, id: 'shell', component: Shell });
const home = createRoute({ getParentRoute: () => shell, path: '/', component: Home });
const store = createRoute({ getParentRoute: () => shell, path: '/apps', component: AppStore });
const list = createRoute({
  getParentRoute: () => shell,
  path: '/$app/$model',
  component: ModelPage,
});
const create = createRoute({
  getParentRoute: () => shell,
  path: '/$app/$model/new',
  component: FormPage,
});
const record = createRoute({
  getParentRoute: () => shell,
  path: '/$app/$model/$id',
  component: FormPage,
});

export const router = createRouter({
  routeTree: root.addChildren([login, shell.addChildren([home, store, list, create, record])]),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queries = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Signed out or forbidden: retrying will not help.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

const element = document.getElementById('root');
if (element !== null)
  createRoot(element).render(
    <StrictMode>
      <QueryClientProvider client={queries}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
