import { createBrowserRouter } from 'react-router-dom';
import { App } from '@/App';
import { AgentsPage } from '@/pages/AgentsPage';
import { GamePage } from '@/pages/GamePage';
import { GamesPage } from '@/pages/GamesPage';
import { HomePage } from '@/pages/HomePage';
import { KnowledgePage } from '@/pages/KnowledgePage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      {
        path: 'games',
        children: [
          { index: true, element: <GamesPage /> },
          { path: ':gameId', element: <GamePage /> },
        ],
      },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'knowledge', element: <KnowledgePage /> },
    ],
  },
]);
