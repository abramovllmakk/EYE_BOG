import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { Empty } from './components/ui';
import { FieldPage, OperationPage, TypePage } from './pages/DetailPages';
import { GraphPage } from './pages/GraphPage';
import {
  ComparePage,
  HeatmapPage,
  OperationsPage,
  TeamsPage,
  TimelinePage,
} from './pages/MorePages';
import { RunsPage } from './pages/RunsPage';
import { TablePage } from './pages/TablePage';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 2000, retry: 1 } } });

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <RunsPage /> },
      { path: 'graph', element: <GraphPage /> },
      { path: 'table', element: <TablePage /> },
      { path: 'heatmap', element: <HeatmapPage /> },
      { path: 'operations', element: <OperationsPage /> },
      { path: 'operations/:id', element: <OperationPage /> },
      { path: 'types/:name', element: <TypePage /> },
      { path: 'fields/:coordinate', element: <FieldPage /> },
      { path: 'compare', element: <ComparePage /> },
      { path: 'timeline', element: <TimelinePage /> },
      { path: 'teams', element: <TeamsPage /> },
      {
        path: '*',
        element: <Empty title="Такой страницы нет">Вернитесь к списку прогонов.</Empty>,
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
