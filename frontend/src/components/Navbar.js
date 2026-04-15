import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Menu, X, Brain, User, LogOut, Settings, Video } from 'lucide-react';
import './Navbar.css';

const Navbar = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { authenticated, user, logout } = useAuth();
  const userMenuRef = useRef(null);

  // Close user menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target)) {
        setShowUserMenu(false);
      }
    };

    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showUserMenu]);

  const handleNavClick = (path, e) => {
      // If user is not authenticated and trying to access protected routes
      if (!authenticated && path !== '/login' && path !== '/signup') {
      e.preventDefault();
      navigate('/signup');
    }
  };

  const navItems = [
    { path: '/mock-interview', label: 'Mock Interview', icon: <Video size={20} /> },
  ];

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  const closeMenu = () => {
    setIsMenuOpen(false);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
    setShowUserMenu(false);
  };

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <Link to="/mock-interview" className="navbar-logo" onClick={closeMenu}>
          <Brain className="logo-icon" />
          <span>Practice2Panel</span>
        </Link>

        <div className={`navbar-menu ${isMenuOpen ? 'active' : ''}`}>
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`navbar-link ${location.pathname === item.path ? 'active' : ''}`}
              onClick={(e) => {
                closeMenu();
                handleNavClick(item.path, e);
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          ))}
        </div>

        <div className="navbar-actions">
          {authenticated ? (
            <div className="user-menu-container" ref={userMenuRef}>
              <button
                className="user-menu-button"
                onClick={() => setShowUserMenu(!showUserMenu)}
              >
                <User size={16} />
                <span>{user?.full_name || 'User'}</span>
              </button>
              {showUserMenu && (
                <div className="user-menu-dropdown">
                  <div className="user-menu-info">
                    <p className="user-menu-name">{user?.full_name}</p>
                    <p className="user-menu-email">{user?.email}</p>
                  </div>
                  <div className="user-menu-divider"></div>
                  <Link
                    to="/profile"
                    className="user-menu-item"
                    onClick={() => setShowUserMenu(false)}
                  >
                    <Settings size={16} />
                    <span>Profile Settings</span>
                  </Link>
                  <button
                    className="user-menu-item logout-item"
                    onClick={handleLogout}
                  >
                    <LogOut size={16} />
                    <span>Logout</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link to="/login" className="btn btn-primary">
              <User size={16} />
              Sign In
            </Link>
          )}
        </div>

        <button className="navbar-toggle" onClick={toggleMenu}>
          {isMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>
    </nav>
  );
};

export default Navbar;
