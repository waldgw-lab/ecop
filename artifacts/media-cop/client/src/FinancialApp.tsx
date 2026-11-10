import { lazy, Suspense, useEffect } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { ThemeProvider } from "./components/ThemeProvider";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toaster";
import Login from "./pages/Login";

const FinancialDashboard = lazy(() => import("./pages/FinancialDashboard"));
function AccessGate() {
  const auth = useQuery<{ authenticated: boolean }>({
    queryKey: ["/api/auth/status"],
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    document.title = "Financial Stability Watch · Internal monitoring";
  }, []);
  if (auth.isPending) return <div className="min-h-screen bg-background text-foreground grid place-items-center">Checking internal access…</div>;
  if (auth.isError) return <div className="min-h-screen bg-background text-foreground grid place-items-center"><div className="text-center p-8"><h1>Access check unavailable</h1><p>No financial data is shown until your session is verified.</p><button className="mt-4 underline" onClick={() => auth.refetch()}>Try again</button></div></div>;
  if (!auth.data.authenticated) return <Login productName="Financial Stability Watch" onLoginSuccess={() => {
    queryClient.clear();
    void auth.refetch();
  }} />;
  return <Suspense fallback={<div className="min-h-screen bg-background text-foreground grid place-items-center">Loading financial picture…</div>}><FinancialDashboard /></Suspense>;
}
export default function FinancialApp() {
  return <QueryClientProvider client={queryClient}><ThemeProvider><TooltipProvider><Toaster /><AccessGate /></TooltipProvider></ThemeProvider></QueryClientProvider>;
}
