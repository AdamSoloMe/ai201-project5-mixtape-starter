"""
tests/test_feed.py — Mixtape

Regression test for the "Friends Listening Now" recency window (Issue #2).
"""

import pytest
from datetime import datetime, timedelta, timezone
from app import create_app, db
from models import User, Song, ListeningEvent, friendships
from services.feed_service import get_friends_listening_now


@pytest.fixture
def app():
    app = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:"})
    with app.app_context():
        db.create_all()
        yield app
        db.drop_all()


@pytest.fixture
def friends(app):
    with app.app_context():
        me = User(username="me", email="me@example.com")
        stale_friend = User(username="stale_friend", email="stale@example.com")
        db.session.add_all([me, stale_friend])
        db.session.flush()

        db.session.execute(friendships.insert().values(user_id=me.id, friend_id=stale_friend.id))
        db.session.execute(friendships.insert().values(user_id=stale_friend.id, friend_id=me.id))

        song = Song(title="Some Song", artist="Someone", shared_by=me.id)
        db.session.add(song)
        db.session.flush()

        db.session.commit()
        yield {"me": me, "stale_friend": stale_friend, "song": song}


def test_stale_listening_event_does_not_appear_as_listening_now(app, friends):
    """
    A friend whose only listening event happened hours ago should NOT
    show up in 'listening now' — that feed is meant to reflect who is
    currently listening, not who listened at some point in the last day.
    """
    with app.app_context():
        me = friends["me"]
        stale_friend = friends["stale_friend"]
        song = friends["song"]

        old_event = ListeningEvent(
            user_id=stale_friend.id,
            song_id=song.id,
            listened_at=datetime.now(timezone.utc) - timedelta(hours=2),
        )
        db.session.add(old_event)
        db.session.commit()

        result = get_friends_listening_now(me.id)
        usernames = [r["friend"]["username"] for r in result]
        assert "stale_friend" not in usernames


def test_recent_listening_event_appears_as_listening_now(app, friends):
    """A friend who listened a few minutes ago should show up."""
    with app.app_context():
        me = friends["me"]
        stale_friend = friends["stale_friend"]
        song = friends["song"]

        recent_event = ListeningEvent(
            user_id=stale_friend.id,
            song_id=song.id,
            listened_at=datetime.now(timezone.utc) - timedelta(minutes=10),
        )
        db.session.add(recent_event)
        db.session.commit()

        result = get_friends_listening_now(me.id)
        usernames = [r["friend"]["username"] for r in result]
        assert "stale_friend" in usernames
