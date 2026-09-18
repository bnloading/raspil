import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from './firebase'
import { departmentOf } from './lib/rbac'
import type { Department, UserDoc } from './types/domain'

const DEPARTMENT_OVERRIDE_KEY = 'departmentView'

interface AuthContextType {
  user: User | null
  userData: UserDoc | null
  loading: boolean
  logout: () => Promise<void>
  /** Which production line the app is currently showing. */
  department: Department
  /** Only an Admin may look at the other line — see setDepartment. */
  canSwitchDepartment: boolean
  setDepartment: (department: Department) => void
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  userData: null,
  loading: true,
  logout: async () => {},
  department: 'ldsp',
  canSwitchDepartment: false,
  setDepartment: () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [storedUserData, setStoredUserData] = useState<UserDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [departmentOverride, setDepartmentOverride] = useState<Department | null>(() => {
    try {
      const saved = localStorage.getItem(DEPARTMENT_OVERRIDE_KEY)
      return saved === 'ldsp' || saved === 'mdf' ? saved : null
    } catch {
      return null // private mode / storage blocked — the switch just won't persist
    }
  })

  useEffect(() => {
    let unsubDoc: (() => void) | null = null

    const unsubAuth = onAuthStateChanged(auth, (firebaseUser) => {
      if (unsubDoc) {
        unsubDoc()
        unsubDoc = null
      }
      setUser(firebaseUser)
      if (firebaseUser) {
        unsubDoc = onSnapshot(
          doc(db, 'users', firebaseUser.uid),
          (snap) => {
            setStoredUserData(snap.exists() ? (snap.data() as UserDoc) : null)
            setLoading(false)
          },
          () => {
            setStoredUserData(null)
            setLoading(false)
          },
        )
      } else {
        setStoredUserData(null)
        setLoading(false)
      }
    })

    return () => {
      unsubAuth()
      if (unsubDoc) unsubDoc()
    }
  }, [])

  // Blocked users are signed out client-side as soon as their doc reflects it. This is a UX
  // convenience, not the security boundary — firestore.rules deny blocked users regardless.
  useEffect(() => {
    if (storedUserData?.blocked) {
      signOut(auth)
    }
  }, [storedUserData])

  // Both production lines run as separate businesses inside one app, and every screen works out
  // which one it is showing from `userData` (see lib/rbac.ts's departmentOf). An Admin who needs to
  // see both therefore gets the switch applied here, on the userData the whole app reads, rather
  // than having a second "which line am I viewing" parameter threaded through every page.
  //
  // This is a view preference, not a permission: `department` appears nowhere in firestore.rules,
  // and an Admin can already read both lines' data. Manager stays pinned to their own line.
  const canSwitchDepartment = storedUserData?.role === 'admin'
  const department: Department =
    canSwitchDepartment && departmentOverride
      ? departmentOverride
      : storedUserData
        ? departmentOf(storedUserData)
        : 'ldsp'
  const userData =
    storedUserData && canSwitchDepartment && departmentOverride
      ? { ...storedUserData, department: departmentOverride }
      : storedUserData

  const setDepartment = (next: Department) => {
    setDepartmentOverride(next)
    try {
      localStorage.setItem(DEPARTMENT_OVERRIDE_KEY, next)
    } catch {
      // best-effort — the switch still applies for this session
    }
  }

  const logout = async () => {
    await signOut(auth)
    setUser(null)
    setStoredUserData(null)
  }

  return (
    <AuthContext.Provider
      value={{ user, userData, loading, logout, department, canSwitchDepartment, setDepartment }}
    >
      {children}
    </AuthContext.Provider>
  )
}
