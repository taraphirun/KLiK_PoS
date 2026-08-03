import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import POSOpeningEntryGuard from './POSOpeningEntryGuard';
import { usePOSProfileStore } from '../stores/posProfileStore';

const ProtectedRoute = ({
  element,
  requiresDeliveryManagement = false,
}: {
  element: React.ReactElement;
  requiresDeliveryManagement?: boolean;
}) => {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  const { posDetails, isLoading: isLoadingProfile } = usePOSProfileStore();

  if (loading) {
    // Show loading spinner while checking authentication
    return (
      <div className="min-h-screen bg-gradient-to-br from-beveren-50 to-beveren-100 flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold text-beveren-700 mb-4">KLiK PoS</div>
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-beveren-700 mx-auto"></div>
          <p className="text-beveren-600 mt-4">Verifying access...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Save the attempted location for redirecting after login
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (requiresDeliveryManagement) {
    // posDetails loads asynchronously after auth - wait for it rather than
    // bouncing the user before the POS Profile flag has actually been read.
    if (!posDetails && isLoadingProfile) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-beveren-50 to-beveren-100 flex items-center justify-center">
          <div className="text-center">
            <div className="text-2xl font-bold text-beveren-700 mb-4">KLiK PoS</div>
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-beveren-700 mx-auto"></div>
            <p className="text-beveren-600 mt-4">Verifying access...</p>
          </div>
        </div>
      );
    }
    if (posDetails?.custom_allow_delivery_management !== 1) {
      return <Navigate to="/pos" replace />;
    }
  }

  // Wrap the element with POSOpeningEntryGuard to ensure opening entry exists
  return (
    <POSOpeningEntryGuard excludePaths={['/settings']}>
      {element}
    </POSOpeningEntryGuard>
  );
};

export default ProtectedRoute;
