import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import { Spinner } from "./components";
import { RouteGuard } from "./RouteGuard";

const Login = lazy(() => import("./pages/Login"));
const Register = lazy(() => import("./pages/Register"));
const CutterDashboard = lazy(() => import("./pages/CutterDashboard"));
const CutterHistory = lazy(() => import("./pages/CutterHistory"));
const PvcDashboard = lazy(() => import("./pages/PvcDashboard"));
const MdfWorkerDashboard = lazy(() => import("./pages/MdfWorkerDashboard"));
const ProductionOrderDetail = lazy(() => import("./pages/ProductionOrderDetail"));

const AdminHome = lazy(() => import("./pages/admin/AdminHome"));
const AdminOrders = lazy(() => import("./pages/admin/AdminOrders"));
const AdminOrderDetail = lazy(() => import("./pages/admin/AdminOrderDetail"));
const AdminUsers = lazy(() => import("./pages/admin/AdminUsers"));
const AdminMaterials = lazy(() => import("./pages/admin/AdminMaterials"));
const AdminReports = lazy(() => import("./pages/admin/AdminReports"));
const ManagerAdvances = lazy(() => import("./pages/manager/ManagerAdvances"));
const ManagerCashbox = lazy(() => import("./pages/manager/ManagerCashbox"));
const AdminAuditLog = lazy(() => import("./pages/admin/AdminAuditLog"));
const AdminCsvSettings = lazy(() => import("./pages/admin/AdminCsvSettings"));
const AdminAttendance = lazy(() => import("./pages/admin/AdminAttendance"));
const AdminSalary = lazy(() => import("./pages/admin/AdminSalary"));
const MySalary = lazy(() => import("./pages/MySalary"));
const MyAttendance = lazy(() => import("./pages/MyAttendance"));
const InvoicePage = lazy(() => import("./pages/InvoicePage"));
const AdminOversightManager = lazy(() => import("./pages/admin/AdminOversightManager"));
const AdminOversightCutting = lazy(() => import("./pages/admin/AdminOversightCutting"));
const AdminOversightPvc = lazy(() => import("./pages/admin/AdminOversightPvc"));
const Assortment = lazy(() => import("./pages/Assortment"));
const Leaderboard = lazy(() => import("./pages/Leaderboard"));
const Camera = lazy(() => import("./pages/Camera"));

const AdminMdfHome = lazy(() => import("./pages/admin/AdminMdfHome"));
const ManagerMdfJournal = lazy(() => import("./pages/manager/ManagerMdfJournal"));

const ManagerDashboard = lazy(() => import("./pages/manager/ManagerDashboard"));
const ManagerJournal = lazy(() => import("./pages/manager/ManagerJournal"));
const ManagerDebt = lazy(() => import("./pages/manager/ManagerDebt"));
const ManagerOrders = lazy(() => import("./pages/manager/ManagerOrders"));
const ManagerOrderDetail = lazy(() => import("./pages/manager/ManagerOrderDetail"));
const ManagerPayments = lazy(() => import("./pages/manager/ManagerPayments"));
const ManagerCuttingQueue = lazy(() => import("./pages/manager/ManagerCuttingQueue"));
const ManagerPvcQueue = lazy(() => import("./pages/manager/ManagerPvcQueue"));
const ManagerReady = lazy(() => import("./pages/manager/ManagerReady"));

const CustomerDashboard = lazy(() => import("./pages/customer/CustomerDashboard"));
const CustomerOrders = lazy(() => import("./pages/customer/CustomerOrders"));
const CustomerDebt = lazy(() => import("./pages/customer/CustomerDebt"));
const OrderBuilder = lazy(() => import("./pages/customer/OrderBuilder"));
const MdfOrderBuilder = lazy(() => import("./pages/customer/MdfOrderBuilder"));
const OrderDetail = lazy(() => import("./pages/customer/OrderDetail"));
const Profile = lazy(() => import("./pages/customer/Profile"));

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route
              path="/"
              element={
                <RouteGuard roles={["customer"]}>
                  <CustomerDashboard />
                </RouteGuard>
              }
            />
            <Route
              path="/dashboard"
              element={
                <RouteGuard roles={["customer"]}>
                  <CustomerDashboard />
                </RouteGuard>
              }
            />
            <Route
              path="/orders"
              element={
                <RouteGuard roles={["customer"]}>
                  <CustomerOrders />
                </RouteGuard>
              }
            />
            <Route
              path="/debt"
              element={
                <RouteGuard roles={["customer"]}>
                  <CustomerDebt />
                </RouteGuard>
              }
            />
            <Route
              path="/order/new"
              element={
                <RouteGuard roles={["customer"]}>
                  <OrderBuilder />
                </RouteGuard>
              }
            />
            <Route
              path="/order/mdf/new"
              element={
                <RouteGuard roles={["customer"]}>
                  <MdfOrderBuilder />
                </RouteGuard>
              }
            />
            <Route
              path="/order/:id"
              element={
                <RouteGuard roles={["customer"]}>
                  <OrderDetail />
                </RouteGuard>
              }
            />
            <Route
              path="/profile"
              element={
                <RouteGuard roles={["customer"]}>
                  <Profile />
                </RouteGuard>
              }
            />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route
              path="/admin"
              element={
                <RouteGuard roles={["admin"]}>
                  <AdminHome />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/orders"
              element={
                <RouteGuard roles={["admin"]}>
                  <AdminOrders />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/order/:id"
              element={
                <RouteGuard roles={["admin"]}>
                  <AdminOrderDetail />
                </RouteGuard>
              }
            />
            <Route
              path="/setup"
              element={
                // Manager may VIEW the customer/staff list (Клиенттер/Қызметкерлер nav items point
                // here); firestore.rules still blocks Manager from writing user-management fields,
                // so this degrades to read-only for Manager without any extra guard logic needed.
                <RouteGuard roles={["admin", "manager"]}>
                  <AdminUsers />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/materials"
              element={
                <RouteGuard roles={["admin", "manager"]}>
                  <AdminMaterials />
                </RouteGuard>
              }
            />
            <Route
              // Same page under the manager's own path, so its nav entry highlights like the rest
              // of the manager section. Editing stays Admin-only inside the page (and in
              // firestore.rules): a Manager sees the stock, the prices and the movement history.
              path="/manager/materials"
              element={
                <RouteGuard roles={["admin", "manager"]}>
                  <AdminMaterials />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/mdf"
              element={
                <RouteGuard roles={["admin", "manager"]}>
                  <AdminMdfHome />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/reports"
              element={
                // Есептер (and Manager's own Төлемдер nav item) point here — Manager can view every
                // report the Admin can (canExportOrders/canViewDebtLedger etc. are Admin+Manager in
                // rbac.ts); nothing on this page writes data a Manager isn't already allowed to.
                <RouteGuard roles={["admin", "manager"]}>
                  <AdminReports />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/audit-log"
              element={
                // Admin-only: Manager can write audit entries (via lib/orderStatus.ts) but the spec
                // explicitly withholds audit-log *reading*/retention-management from Manager.
                <RouteGuard roles={["admin"]}>
                  <AdminAuditLog />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/csv-settings"
              element={
                <RouteGuard roles={["admin"]}>
                  <AdminCsvSettings />
                </RouteGuard>
              }
            />
            {/* One invoice route for every role — the page and firestore.rules together decide
                what each viewer may see and do with it. */}
            <Route
              path="/invoice/:id"
              element={
                <RouteGuard roles={["admin", "manager", "customer"]}>
                  <InvoicePage />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/attendance"
              element={
                <RouteGuard roles={["admin"]}>
                  <AdminAttendance />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/salary"
              element={
                <RouteGuard roles={["admin"]}>
                  <AdminSalary />
                </RouteGuard>
              }
            />
            {/* Every employee sees their OWN salary/attendance; the queries are uid-scoped and
                firestore.rules refuses anyone else's documents. */}
            <Route
              path="/salary"
              element={
                <RouteGuard roles={["admin", "manager", "raspil", "pvh", "cnc", "sanding", "painting", "vacuum"]}>
                  <MySalary />
                </RouteGuard>
              }
            />
            <Route
              path="/my-attendance"
              element={
                <RouteGuard roles={["admin", "manager", "raspil", "pvh", "cnc", "sanding", "painting", "vacuum"]}>
                  <MyAttendance />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/oversight/manager"
              element={
                <RouteGuard roles={["admin"]}>
                  <AdminOversightManager />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/oversight/cutting"
              element={
                <RouteGuard roles={["admin"]}>
                  <AdminOversightCutting />
                </RouteGuard>
              }
            />
            <Route
              path="/admin/oversight/pvc"
              element={
                <RouteGuard roles={["admin"]}>
                  <AdminOversightPvc />
                </RouteGuard>
              }
            />
            <Route
              path="/manager"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerDashboard />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/new"
              element={
                // Manager doesn't create orders (only customers do) — "Жаңа заказдар" means the
                // inbox of newly-submitted orders awaiting review, not an order-creation form.
                <RouteGuard roles={["manager", "admin"]}>
                  <Navigate to="/manager/orders?status=submitted" replace />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/journal"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerJournal />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/mdf-journal"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerMdfJournal />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/orders"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerOrders />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/order/:id"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerOrderDetail />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/advances"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerAdvances />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/cashbox"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerCashbox />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/debt"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerDebt />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/payments"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerPayments />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/cutting"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerCuttingQueue />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/pvc"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerPvcQueue />
                </RouteGuard>
              }
            />
            <Route
              path="/manager/ready"
              element={
                <RouteGuard roles={["manager", "admin"]}>
                  <ManagerReady />
                </RouteGuard>
              }
            />
            <Route
              path="/cutting"
              element={
                <RouteGuard roles={["raspil"]}>
                  <CutterDashboard />
                </RouteGuard>
              }
            />
            <Route
              path="/cutting/history"
              element={
                <RouteGuard roles={["raspil"]}>
                  <CutterHistory />
                </RouteGuard>
              }
            />
            <Route
              path="/cutting/order/:id"
              element={
                <RouteGuard roles={["raspil"]}>
                  <ProductionOrderDetail />
                </RouteGuard>
              }
            />
            <Route
              path="/pvc"
              element={
                <RouteGuard roles={["pvh"]}>
                  <PvcDashboard />
                </RouteGuard>
              }
            />
            <Route
              path="/pvc/order/:id"
              element={
                <RouteGuard roles={["pvh"]}>
                  <ProductionOrderDetail />
                </RouteGuard>
              }
            />
            <Route
              path="/cnc"
              element={
                <RouteGuard roles={["cnc"]}>
                  <MdfWorkerDashboard />
                </RouteGuard>
              }
            />
            <Route
              path="/cnc/order/:id"
              element={
                <RouteGuard roles={["cnc"]}>
                  <ProductionOrderDetail />
                </RouteGuard>
              }
            />
            <Route
              path="/sanding"
              element={
                <RouteGuard roles={["sanding"]}>
                  <MdfWorkerDashboard />
                </RouteGuard>
              }
            />
            <Route
              path="/sanding/order/:id"
              element={
                <RouteGuard roles={["sanding"]}>
                  <ProductionOrderDetail />
                </RouteGuard>
              }
            />
            <Route
              path="/painting"
              element={
                <RouteGuard roles={["painting"]}>
                  <MdfWorkerDashboard />
                </RouteGuard>
              }
            />
            <Route
              path="/painting/order/:id"
              element={
                <RouteGuard roles={["painting"]}>
                  <ProductionOrderDetail />
                </RouteGuard>
              }
            />
            <Route
              path="/vacuum"
              element={
                <RouteGuard roles={["vacuum"]}>
                  <MdfWorkerDashboard />
                </RouteGuard>
              }
            />
            <Route
              path="/vacuum/order/:id"
              element={
                <RouteGuard roles={["vacuum"]}>
                  <ProductionOrderDetail />
                </RouteGuard>
              }
            />
            <Route path="/assortment" element={<Assortment />} />
            <Route
              path="/leaderboard"
              element={
                <RouteGuard roles={["admin"]}>
                  <Leaderboard />
                </RouteGuard>
              }
            />
            <Route path="/camera" element={<Camera />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
