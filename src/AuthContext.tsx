import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from './firebase'
import type { UserDoc } from './types/domain'

interface AuthContextType {
  user: User | null
  userData: UserDoc | null
  loading: boolean
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  userData: null,
  loading: true,
  logout: async () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userData, setUserData] = useState<UserDoc | null>(null)
  const [loading, setLoading] = useState(true)

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
            setUserData(snap.exists() ? (snap.data() as UserDoc) : null)
            setLoading(false)
          },
          () => {
            setUserData(null)
            setLoading(false)
          },
        )
      } else {
        setUserData(null)
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
    if (userData?.blocked) {
      signOut(auth)
    }
  }, [userData])

  const logout = async () => {
    await signOut(auth)
    setUser(null)
    setUserData(null)
  }

  return (
    <AuthContext.Provider value={{ user, userData, loading, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
