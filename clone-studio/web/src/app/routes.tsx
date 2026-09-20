import { createBrowserRouter } from "react-router";
import { Shell } from "./Shell.js";
import { HomePage } from "../pages/HomePage.js";
import { SettingsPage } from "../pages/SettingsPage.js";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);
