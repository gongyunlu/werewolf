import { createBrowserRouter } from 'react-router-dom';
import { App } from '@/App';
import { AgentsPage } from '@/pages/AgentsPage';
import { GamePage } from '@/pages/GamePage';
import { GamesPage } from '@/pages/GamesPage';
import { HomePage } from '@/pages/HomePage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'games', element: <GamesPage /> },
      { path: 'games/:gameId', element: <GamePage /> },
      { path: 'agents', element: <AgentsPage /> },
    ],
  },
]);
