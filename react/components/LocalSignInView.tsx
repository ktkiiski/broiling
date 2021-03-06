/* eslint-disable no-underscore-dangle */
import * as React from 'react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import * as api from '../../auth-local-api';
import { signJwt } from '../../jwt';
import { randomize } from '../../strings';
import { buildQuery, parseQuery } from '../../url';
import type { User } from '../../users';
import { useList, useOperation } from '../api';
import { useUniqueId } from '../client';
import styles from './LocalSignInView.module.css';

function LocalSignInView(): JSX.Element {
    const location = useLocation();
    const [isAdmin, setIsAdmin] = useState(false);
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [hasAvatar, setHasAvatar] = useState(true);
    const id = useUniqueId();
    const createUserOperation = useOperation(api._createUser);
    const signUp = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const avatarHash = randomize(32, '01234567890abcdef');
        const picture = hasAvatar ? `https://www.gravatar.com/avatar/${avatarHash}?d=wavatar` : null;
        const user = await createUserOperation.post({ email, name, picture });
        await signInAs(user);
    };
    const [users] = useList(api._listUsers, {
        ordering: 'name',
        direction: 'asc',
    });
    const query = parseQuery(location.search);

    async function signInAs(user: User) {
        const idTokenPayload: { [key: string]: unknown } = {
            'sub': user.id,
            'exp': Math.floor(new Date().getTime() / 1000) + 60 * 60,
            'cognito:groups': isAdmin ? ['Administrators'] : [],
        };
        if (user.email) {
            idTokenPayload.email = user.email;
        }
        if (user.name) {
            idTokenPayload.name = user.name;
        }
        if (user.picture) {
            idTokenPayload.picture = user.picture;
        }
        // Create the JWT token
        const idToken = signJwt(idTokenPayload, 'LOCAL_SECRET');
        const code = buildQuery({ id_token: idToken });
        const redirectQuery = buildQuery({ code, state: query.state });
        window.location.href = `${query.redirect_uri}?${redirectQuery}`;
    }

    return (
        <div className={styles.container}>
            <h1>Log in</h1>
            <p>
                <label className={styles.formLabel}>
                    <input type="checkbox" checked={isAdmin} onChange={(event) => setIsAdmin(event.target.checked)} />
                    Log in as an admin
                </label>
            </p>
            <h4>Sign up as a new user</h4>
            <form onSubmit={signUp}>
                <div className={styles.formGroup}>
                    <label className={styles.formLabel} htmlFor={`email-input-${id}`}>
                        Email
                    </label>
                </div>
                <div className={styles.formGroup}>
                    <input
                        id={`email-input-${id}`}
                        type="email"
                        placeholder="Type an unique email address"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                    />
                </div>
                <div className={styles.formGroup}>
                    <label className={styles.formLabel} htmlFor={`name-input-${id}`}>
                        Name
                    </label>
                </div>
                <div className={styles.formGroup}>
                    <input
                        id={`name-input-${id}`}
                        type="text"
                        placeholder="Type the full name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </div>
                <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                        <input
                            type="checkbox"
                            checked={hasAvatar}
                            onChange={(event) => setHasAvatar(event.target.checked)}
                            id="avatar-checkbox"
                        />
                        Has avatar
                    </label>
                </div>
                <div className={styles.formGroup}>
                    <button className={styles.signInButton} type="submit">
                        Sign up
                    </button>
                </div>
            </form>
            {!users?.length ? null : (
                <>
                    <hr />
                    <h4>Sign in with an existing user</h4>
                    {users.map((user) => (
                        <button
                            type="button"
                            key={user.id}
                            onClick={() => signInAs(user)}
                            className={styles.userButton}
                        >
                            {`${user.name} (${user.email || 'no email'})`}
                        </button>
                    ))}
                </>
            )}
        </div>
    );
}

export default LocalSignInView;
