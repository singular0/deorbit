FROM python:3.13-slim

COPY pyproject.toml /src/
COPY deorbit /src/deorbit

# mtp-fs.js is not in git, so a clone lacks it until it is put there by hand.
# Stop rather than build an image that cannot bind a robot.
RUN if [ ! -f /src/deorbit/static/mtp-fs.js ]; then \
      printf '%s\n' \
        '' \
        'deorbit/static/mtp-fs.js is missing, so the image is not built.' \
        '' \
        'The web page needs this file to bind a robot over USB. It is withheld' \
        'from the source and is not in the git repository, because it contains' \
        'an exploit that the Vacuula team (https://github.com/vacuula) is in the' \
        'process of disclosing to Vorwerk. A clone of the repository therefore' \
        'does not have it.' \
        '' \
        'Put mtp-fs.js in deorbit/static/ and build again.' \
        '' >&2; \
      exit 1; \
    fi

RUN pip install --no-cache-dir --root-user-action=ignore /src

# The server reads ./deorbit.yml and resolves the relative paths in it, such as
# certs/, against that file's directory. Both are mounted here at run time.
WORKDIR /data

EXPOSE 3443 8080

# As PID 1, Python ignores SIGTERM; SIGINT closes the robot sessions and exits.
STOPSIGNAL SIGINT

CMD ["python", "-m", "deorbit"]
