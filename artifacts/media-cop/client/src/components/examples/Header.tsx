import Header from '../Header';
import { useState } from 'react';

export default function HeaderExample() {
  const [autoRefresh, setAutoRefresh] = useState(true);

  return (
    <Header
      autoRefresh={autoRefresh}
      onAutoRefreshChange={setAutoRefresh}
      onManualRefresh={() => console.log('Refreshing...')}
      isRefreshing={false}
    />
  );
}
