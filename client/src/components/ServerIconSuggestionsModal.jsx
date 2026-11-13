import Modal from './Modal';
import ServerIconSuggestions from './ServerIconSuggestions';

export default function ServerIconSuggestionsModal({
  server,
  me,
  socket,
  onUpdated,
  onClose
}) {
  return (
    <Modal
      title="Icon ideas"
      subtitle={`Suggest a new look for ${server.name}, or vote on an idea.`}
      onClose={onClose}
      width={760}
    >
      <ServerIconSuggestions
        server={server}
        me={me}
        socket={socket}
        onUpdated={onUpdated}
      />
    </Modal>
  );
}
